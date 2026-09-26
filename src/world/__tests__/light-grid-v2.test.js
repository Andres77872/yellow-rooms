import { describe, expect, it } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { CELL, CHUNK, DOOR_H, FRAME_W, FURN_MARGIN, WALL_H, WINDOW_HEAD_Y, WINDOW_SILL_H, layerY } from '../constants.js'
import { PASSAGE_DOOR, PASSAGE_WALL, WALL_WINDOW } from '../mapTypes.js'
import { FURN_CABINET, FURN_DESK, FURN_TABLE, FURN_WARDROBE } from '../furniture.js'
import {
  GLASS_T,
  GRID_SCHEMA_VERSION,
  OCC_COL_RANGE,
  OCC_MASK_BITS,
  OCC_MAX_H,
  OCC_OFFSETS,
  OCC_ROW_RANGE,
  OCC_T_SHIFT_A,
  OCC_UNIT_XZ,
  OCC_UNIT_Y,
  decodeOccBox,
  occMaskBit,
  packOccBox,
  texelIndex,
} from '../lightGrid/gridSpec.js'
import { LightGrid } from '../lightGrid/LightGrid.js'
import { FURNITURE_PROXIES, OCC_MAX_H as PROXY_MAX_H, furnitureProxyBoxes } from '../objects/furniture/proxies.js'

// Grid schema v2 (engine-improvement chapter 14 P8/P16): furniture occupancy
// and the 2.5D raycast used by the flashlight's bounce light.

function chunk(cx, cy, cz, build = () => {}) {
  const d = new ChunkData(cx, cy, cz, 0)
  build(d)
  return d
}

function withFurniture(grid) {
  grid.proxyBoxes = furnitureProxyBoxes
  return grid
}

// A piece centred in chunk-local cell (lx, lz).
const piece = (kind, lx, lz, facing = 0) => ({
  kind,
  lx,
  lz,
  x: (lx + 0.5) * CELL,
  z: (lz + 0.5) * CELL,
  w: 1,
  d: 1,
  facing,
})

describe('occupancy encoding', () => {
  it('is schema 2 and keeps every proxy below the shader bound', () => {
    expect(GRID_SCHEMA_VERSION).toBe(2)
    expect(PROXY_MAX_H).toBeLessThanOrEqual(OCC_MAX_H)
    for (const boxes of Object.values(FURNITURE_PROXIES)) {
      expect(boxes.length).toBeLessThanOrEqual(2)
      for (const b of boxes) expect(b.y1).toBeLessThanOrEqual(OCC_MAX_H)
    }
  })

  it('orders the 5x5 ring by distance and builds exact rectangle masks', () => {
    expect(OCC_OFFSETS).toHaveLength(25)
    expect(OCC_OFFSETS[0]).toEqual([0, 0])
    const ring = (o) => Math.max(Math.abs(o[0]), Math.abs(o[1]))
    for (let i = 1; i < 25; i++) expect(ring(OCC_OFFSETS[i])).toBeGreaterThanOrEqual(ring(OCC_OFFSETS[i - 1]))
    expect(occMaskBit(0, 0)).toBe(0)
    expect(occMaskBit(3, 0)).toBe(-1)
    for (let lo = -2; lo <= 2; lo++) {
      for (let hi = lo; hi <= 2; hi++) {
        const col = OCC_COL_RANGE[(lo + 2) * 5 + hi + 2]
        const row = OCC_ROW_RANGE[(lo + 2) * 5 + hi + 2]
        OCC_OFFSETS.forEach(([dx, dz], b) => {
          expect(!!(col & (1 << b))).toBe(dx >= lo && dx <= hi)
          expect(!!(row & (1 << b))).toBe(dz >= lo && dz <= hi)
        })
      }
    }
  })

  it('round-trips a box within one quantum, rounded outward', () => {
    const box = { x0: 0.31, x1: 2.69, z0: 0.52, z1: 1.21, y0: 0.04, y1: 0.781, t: 3 }
    const p = packOccBox(box)
    const d = decodeOccBox(p.xz, p.y, p.t)
    expect(d.x0).toBeLessThanOrEqual(box.x0 + 1e-9)
    expect(d.x1).toBeGreaterThanOrEqual(box.x1 - 1e-9)
    expect(box.x0 - d.x0).toBeLessThan(OCC_UNIT_XZ + 1e-9)
    expect(d.x1 - box.x1).toBeLessThan(OCC_UNIT_XZ + 1e-9)
    expect(d.z0).toBeLessThanOrEqual(box.z0 + 1e-9)
    expect(d.z1).toBeGreaterThanOrEqual(box.z1 - 1e-9)
    expect(d.y0).toBeLessThanOrEqual(box.y0 + 1e-9)
    expect(d.y1).toBeGreaterThanOrEqual(box.y1 - 1e-9)
    expect(d.y1 - box.y1).toBeLessThan(OCC_UNIT_Y + 1e-9)
    expect(d.t).toBe(3)
    expect(decodeOccBox(0, 0)).toBeNull()
  })

  it('bakes proxies and same-chunk ring masks at ingest, and clears them on unload', () => {
    const grid = withFurniture(new LightGrid())
    const a = FURN_MARGIN + 1
    const data = chunk(0, 0, 0, (d) => {
      d.furniture.push(piece(FURN_WARDROBE, a, a, 1), piece(FURN_DESK, a + 2, a, 0))
    })
    grid.addChunk(data)
    const t = texelIndex(a, a, 0) * 4
    const occ = grid.occ
    const boxA = decodeOccBox(occ[t], occ[t + 1] & 0xffff, (occ[t + 3] >>> OCC_T_SHIFT_A) & 7)
    expect(boxA).not.toBeNull()
    expect(boxA.y1).toBeGreaterThan(2) // the wardrobe is tall
    // The own cell is furnished (bit 0); the desk two cells east is bit (2, 0).
    const mask = occ[t + 3] & OCC_MASK_BITS
    expect(mask & 1).toBe(1)
    expect(mask & (1 << occMaskBit(2, 0))).not.toBe(0)
    expect(mask & (1 << occMaskBit(-1, 0))).toBe(0)
    // A cell two away from both pieces still sees them in its ring.
    const t2 = texelIndex(a + 1, a + 2, 0) * 4
    const mask2 = occ[t2 + 3] & OCC_MASK_BITS
    expect(mask2 & (1 << occMaskBit(-1, -2))).not.toBe(0)
    // Masks never reach outside the chunk (FURN_MARGIN keeps ring 2 inside).
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const m = occ[texelIndex(lx, lz, 0) * 4 + 3] & OCC_MASK_BITS
        OCC_OFFSETS.forEach(([dx, dz], b) => {
          if (!(m & (1 << b))) return
          expect(lx + dx).toBeGreaterThanOrEqual(0)
          expect(lz + dz).toBeGreaterThanOrEqual(0)
          expect(lx + dx).toBeLessThan(CHUNK)
          expect(lz + dz).toBeLessThan(CHUNK)
        })
      }
    }
    // Deterministic: a second grid bakes identical words.
    const again = withFurniture(new LightGrid())
    again.addChunk(data)
    expect(Array.from(again.occ.subarray(0, CHUNK * 4))).toEqual(Array.from(occ.subarray(0, CHUNK * 4)))
    grid.removeChunk(0, 0, 0)
    expect(occ[t] | occ[t + 1] | occ[t + 3]).toBe(0)
  })

  it('marks occupancy dirty for upload with the chunk', () => {
    const grid = withFurniture(new LightGrid())
    grid.takeDirty()
    grid.addChunk(chunk(0, 0, 0, (d) => d.furniture.push(piece(FURN_CABINET, 4, 4))))
    const dirty = grid.takeDirty()
    expect(dirty.occ.length).toBeGreaterThan(0)
  })
})

describe('edge-texel ownership (the retired owner texture)', () => {
  it('agrees with the owner table under random residency, vertical aliasing included', () => {
    const grid = new LightGrid()
    let s = 7
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const resident = new Set()
    for (let step = 0; step < 60; step++) {
      const cx = Math.floor(rnd() * 5) - 2
      const cz = Math.floor(rnd() * 5) - 2
      const cy = Math.floor(rnd() * 9) - 1 // spans more than GRID_FLOORS: aliasing
      const key = `${cx},${cy},${cz}`
      if (resident.has(key) && rnd() < 0.5) {
        grid.removeChunk(cx, cy, cz)
        resident.delete(key)
      } else if (!resident.has(key)) {
        grid.addChunk(chunk(cx, cy, cz))
        resident.add(key)
      }
      if (rnd() < 0.2) grid.setPlayerFloor(Math.floor(rnd() * 6) - 1)
      for (let k = 0; k < 40; k++) {
        const gx = Math.floor(rnd() * CHUNK * 5) - CHUNK * 2
        const gz = Math.floor(rnd() * CHUNK * 5) - CHUNK * 2
        const gcy = Math.floor(rnd() * 9) - 1
        expect(grid._texel(gx, gz, gcy) >= 0).toBe(grid._recordAt(gx, gz, gcy) !== null)
      }
    }
  })
})

describe('LightGrid.raycast (the bounce light)', () => {
  // A wall on line lx = 6 of chunk (0,0,0) with a doorway at row 4 (a door
  // edge is an open wall slot carrying the door passage).
  function roomGrid() {
    const grid = withFurniture(new LightGrid())
    grid.addChunk(
      chunk(0, 0, 0, (d) => {
        for (let z = 0; z < CHUNK; z++) {
          if (z === 4) d.setV(6, z, 0, PASSAGE_DOOR)
          else d.setV(6, z, 1, PASSAGE_WALL)
        }
        d.furniture.push(piece(FURN_CABINET, 3, 9))
      })
    )
    return grid
  }

  it('hits a wall at the right depth, with the wall normal', () => {
    const grid = roomGrid()
    const h = grid.raycast(2 * CELL, 1.5, 2.5 * CELL, 1, 0, 0, 30)
    expect(h.kind).toBe('wall')
    expect(h.x).toBeCloseTo(6 * CELL, 5)
    expect(h.nx).toBe(-1)
  })

  it('passes through the doorway under the lintel but stops at the header and the jambs', () => {
    const grid = roomGrid()
    const zDoor = 4.5 * CELL
    const through = grid.raycast(2 * CELL, 1.5, zDoor, 1, 0, 0, 12)
    expect(through === null || through.x > 6 * CELL + 0.01).toBe(true)
    // Aimed at the header (above DOOR_H at the wall line).
    const up = (DOOR_H + 0.3 - 1.5) / (6 * CELL - 2 * CELL)
    const len = Math.hypot(1, up)
    const header = grid.raycast(2 * CELL, 1.5, zDoor, 1 / len, up / len, 0, 30)
    expect(header.kind).toBe('wall')
    // The jamb: within FRAME_W of the doorway cell's edge.
    const jamb = grid.raycast(2 * CELL, 1.5, 4 * CELL + FRAME_W * 0.5, 1, 0, 0, 30)
    expect(jamb.kind).toBe('wall')
  })

  it('hits the floor and the ceiling of the storey', () => {
    const grid = roomGrid()
    const down = grid.raycast(1.5 * CELL, 1.7, 1.5 * CELL, 0, -1, 0, 10)
    expect(down.kind).toBe('floor')
    expect(down.y).toBeCloseTo(layerY(0), 5)
    expect(down.ny).toBe(1)
    const up = grid.raycast(1.5 * CELL, 1.7, 1.5 * CELL, 0, 1, 0, 10)
    expect(up.kind).toBe('ceiling')
    expect(up.y).toBeCloseTo(WALL_H, 5)
  })

  it('hits a furniture proxy before the floor behind it', () => {
    const grid = roomGrid()
    // Straight down onto the cabinet in cell (3, 9).
    const h = grid.raycast(3.5 * CELL, 2.6, 9.5 * CELL, 0, -1, 0, 10)
    expect(h.kind).toBe('furniture')
    expect(h.y).toBeGreaterThan(1.5)
  })

  it('stops at a window sill and header and passes the glazing with its transmission', () => {
    const grid = new LightGrid()
    grid.addChunk(
      chunk(0, 0, 0, (d) => {
        for (let z = 0; z < CHUNK; z++) {
          d.setV(6, z, 1, PASSAGE_WALL, z === 4 ? WALL_WINDOW : undefined)
          d.setV(10, z, 1, PASSAGE_WALL)
        }
      })
    )
    const z = 4.5 * CELL
    const glazing = grid.raycast(2 * CELL, (WINDOW_SILL_H + WINDOW_HEAD_Y) / 2, z, 1, 0, 0, 40)
    expect(glazing.kind).toBe('wall')
    expect(glazing.x).toBeCloseTo(10 * CELL, 5)
    expect(glazing.trans).toBeCloseTo(GLASS_T, 6)
    expect(glazing.tTrans).toBeCloseTo(4 * CELL, 5)
    for (const y of [WINDOW_SILL_H - 0.2, WINDOW_HEAD_Y + 0.2]) {
      const h = grid.raycast(2 * CELL, y, z, 1, 0, 0, 40)
      expect(h.kind, `y ${y}`).toBe('wall')
      expect(h.x).toBeCloseTo(6 * CELL, 5)
      expect(h.trans).toBe(1)
    }
  })

  it('passes a see-through leg frame with its transmission and stops at the table top', () => {
    const grid = withFurniture(new LightGrid())
    grid.addChunk(
      chunk(0, 0, 0, (d) => {
        for (let z = 0; z < CHUNK; z++) d.setV(6, z, 1, PASSAGE_WALL)
        d.furniture.push(piece(FURN_TABLE, 3, 9))
      })
    )
    const legs = grid.raycast(1.5 * CELL, 0.3, 9.5 * CELL, 1, 0, 0, 30)
    expect(legs.kind).toBe('wall')
    expect(legs.trans).toBeCloseTo(7 / 8, 6)
    expect(legs.tTrans).toBeLessThan(2 * CELL)
    const top = grid.raycast(1.5 * CELL, 0.65, 9.5 * CELL, 1, 0, 0, 30)
    expect(top.kind).toBe('furniture')
    expect(top.x).toBeLessThan(4 * CELL)
  })

  describe('through slab holes', () => {
    // An atrium void over cells 5..7 x 5..7 between storeys 0 and 1.
    function atrium() {
      const lower = chunk(0, 0, 0)
      lower.hasCeilHole = (lx, lz) => lx >= 5 && lx <= 7 && lz >= 5 && lz <= 7
      const upper = chunk(0, 1, 0)
      upper.hasFloorHole = lower.hasCeilHole
      const grid = new LightGrid()
      grid.addChunk(lower)
      grid.addChunk(upper)
      return grid
    }

    it('falls through the void to the storey below', () => {
      const grid = atrium()
      const down = grid.raycast(6.5 * CELL, layerY(1) + 1.7, 6.5 * CELL, 0, -1, 0, 20)
      expect(down.kind).toBe('floor')
      expect(down.y).toBeCloseTo(layerY(0), 5)
      // Outside the void the upper floor stops it.
      const solid = grid.raycast(2.5 * CELL, layerY(1) + 1.7, 2.5 * CELL, 0, -1, 0, 20)
      expect(solid.kind).toBe('floor')
      expect(solid.y).toBeCloseTo(layerY(1), 5)
    })

    it('crosses cell edges inside the slab band and lands beyond the void', () => {
      const grid = atrium()
      const len = Math.hypot(1, 0.5)
      const oy = layerY(1) + 1
      const h = grid.raycast(5.2 * CELL, oy, 6.5 * CELL, 1 / len, -0.5 / len, 0, 40)
      expect(h.kind).toBe('floor')
      expect(h.y).toBeCloseTo(layerY(0), 5)
      expect(h.x).toBeCloseTo(5.2 * CELL + oy * 2, 4)
    })

    it('starts inside the slab band (on a stair through the void)', () => {
      const grid = atrium()
      const oy = layerY(0) + WALL_H + 0.2
      const down = grid.raycast(6.5 * CELL, oy, 6.5 * CELL, 0, -1, 0, 20)
      expect(down.kind).toBe('floor')
      expect(down.y).toBeCloseTo(layerY(0), 5)
      const up = grid.raycast(6.5 * CELL, oy, 6.5 * CELL, 0, 1, 0, 20)
      expect(up.kind).toBe('ceiling')
      expect(up.y).toBeCloseTo(layerY(1) + WALL_H, 5)
      // Sideways the slab's cut face at the void's edge stops it.
      const side = grid.raycast(6.5 * CELL, oy, 6.5 * CELL, 1, 0, 0, 20)
      expect(side.kind).toBe('wall')
      expect(side.x).toBeCloseTo(8 * CELL, 5)
      expect(side.nx).toBe(-1)
    })
  })
})
